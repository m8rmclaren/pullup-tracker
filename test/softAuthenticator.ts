// A software WebAuthn authenticator: real P-256 keys, a CBOR attestation object with
// attestation "none", and ECDSA-signed assertions. It produces the JSON a browser hands to
// the app, so the server's verification runs exactly as it does for a phone.
import { type KeyObject, createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

type CborValue = number | string | Uint8Array | CborValue[] | Map<number | string, CborValue>;

function cborHead(majorType: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(majorType << 5) | length]);
  if (length < 0x100) return Buffer.from([(majorType << 5) | 24, length]);
  if (length < 0x10000) return Buffer.from([(majorType << 5) | 25, length >> 8, length & 0xff]);
  const head = Buffer.alloc(5);
  head[0] = (majorType << 5) | 26;
  head.writeUInt32BE(length, 1);
  return head;
}

/** The subset of CBOR WebAuthn needs: ints, byte and text strings, arrays and maps. */
export function encodeCbor(value: CborValue): Buffer {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(encodeCbor)]);
  return Buffer.concat([cborHead(5, value.size), ...[...value].flatMap(([key, inner]) => [encodeCbor(key), encodeCbor(inner)])]);
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();
const base64url = (data: Uint8Array) => Buffer.from(data).toString('base64url');

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED_CREDENTIAL = 0x40;

interface StoredCredential {
  id: Buffer;
  privateKey: KeyObject;
  publicKey: KeyObject;
  rpId: string;
  userHandle: string;
  signCount: number;
}

interface CreationOptions {
  challenge: string;
  rp: { id?: string };
  user: { id: string };
  excludeCredentials?: { id: string }[];
}

interface RequestOptions {
  challenge: string;
  rpId?: string;
}

export interface AuthenticatorOptions {
  /** Synced passkeys report 0 forever; a hardware key counts up. */
  countsSignatures?: boolean;
  /** Clear to act like an authenticator that skipped Face ID. */
  verifiesUser?: boolean;
}

export class SoftAuthenticator {
  readonly credentials: StoredCredential[] = [];

  constructor(private readonly options: AuthenticatorOptions = {}) {}

  private flags(extra = 0): number {
    return FLAG_USER_PRESENT | (this.options.verifiesUser === false ? 0 : FLAG_USER_VERIFIED) | FLAG_BACKUP_ELIGIBLE | FLAG_BACKED_UP | extra;
  }

  private nextSignCount(credential: StoredCredential): Buffer {
    if (this.options.countsSignatures) credential.signCount++;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(credential.signCount);
    return count;
  }

  /** What navigator.credentials.create resolves to, serialized as @simplewebauthn/browser does. */
  create(options: CreationOptions, origin: string) {
    const rpId = options.rp.id ?? new URL(origin).hostname;
    if (options.excludeCredentials?.some((excluded) => this.credentials.some((credential) => base64url(credential.id) === excluded.id))) throw new Error('InvalidStateError: already registered');
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const credential: StoredCredential = { id: randomBytes(32), privateKey, publicKey, rpId, userHandle: options.user.id, signCount: 0 };
    this.credentials.push(credential);

    const jwk = publicKey.export({ format: 'jwk' });
    const coseKey = new Map<number, CborValue>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]);
    const credentialIdLength = Buffer.alloc(2);
    credentialIdLength.writeUInt16BE(credential.id.length);
    const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(FLAG_ATTESTED_CREDENTIAL)]), this.nextSignCount(credential), Buffer.alloc(16), credentialIdLength, credential.id, encodeCbor(coseKey)]);
    const attestationObject = encodeCbor(
      new Map<string, CborValue>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authenticatorData],
      ]),
    );
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    return {
      id: base64url(credential.id),
      rawId: base64url(credential.id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: { clientDataJSON: base64url(clientDataJSON), attestationObject: base64url(attestationObject), transports: ['internal', 'hybrid'] },
    };
  }

  /** What navigator.credentials.get resolves to: a discoverable credential, so it carries the user handle. */
  get(options: RequestOptions, origin: string, credential = this.credentials[0]) {
    if (!credential) throw new Error('NotAllowedError: no passkey');
    const rpId = options.rpId ?? new URL(origin).hostname;
    const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([this.flags()]), this.nextSignCount(credential)]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const signature = createSign('sha256').update(Buffer.concat([authenticatorData, sha256(clientDataJSON)])).sign(credential.privateKey);
    return {
      id: base64url(credential.id),
      rawId: base64url(credential.id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: { clientDataJSON: base64url(clientDataJSON), authenticatorData: base64url(authenticatorData), signature: base64url(signature), userHandle: credential.userHandle },
    };
  }
}
