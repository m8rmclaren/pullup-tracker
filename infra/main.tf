resource "random_id" "suffix" {
  byte_length = 4
}

data "aws_caller_identity" "current" {}

locals {
  suffix        = random_id.suffix.hex
  custom_domain = var.domain_name != ""
  # Created by infra/bootstrap.yaml; the deploy role may only create roles that carry it.
  lambda_boundary = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/${var.name}-lambda-boundary"
}

# ---------------------------------------------------------------- site bucket

resource "aws_s3_bucket" "site" {
  bucket        = "${var.name}-site-${local.suffix}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "site" {
  statement {
    sid       = "CloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.app.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket     = aws_s3_bucket.site.id
  policy     = data.aws_iam_policy_document.site.json
  depends_on = [aws_s3_bucket_public_access_block.site]
}

# ---------------------------------------------------------------- data table

# One table for every user. Key layout is documented in src/lambda/dynamodb.ts. Device
# tokens and invite codes are stored only as SHA-256 digests.
resource "aws_dynamodb_table" "data" {
  name                        = var.name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "srv"
    type = "N"
  }
  attribute {
    name = "ts"
    type = "N"
  }
  attribute {
    name = "mpk"
    type = "S"
  }
  attribute {
    name = "msk"
    type = "S"
  }

  # A user's entries by server write time: the delta-sync cursor.
  local_secondary_index {
    name            = "by-srv"
    range_key       = "srv"
    projection_type = "ALL"
  }

  # A user's entries by when the set was done: recomputing one day's total.
  local_secondary_index {
    name            = "by-ts"
    range_key       = "ts"
    projection_type = "ALL"
  }

  # Every user's day totals for a month: the leaderboard.
  global_secondary_index {
    name            = "by-month"
    projection_type = "ALL"
    key_schema {
      attribute_name = "mpk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "msk"
      key_type       = "RANGE"
    }
  }

  # Invites carry `ttl`; expiry is also checked on redeem since TTL deletion lags.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  # The undo of last resort: restore the table to any second in the last 35 days.
  point_in_time_recovery {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------- lambda

data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../dist/lambda"
  output_path = "${path.module}/.build/api.zip"
}

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name                 = "${var.name}-api-${local.suffix}"
  assume_role_policy   = data.aws_iam_policy_document.assume_lambda.json
  permissions_boundary = local.lambda_boundary
}

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "Data"
    actions   = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"]
    resources = [aws_dynamodb_table.data.arn, "${aws_dynamodb_table.data.arn}/index/*"]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }
}

resource "aws_iam_role_policy" "api" {
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${var.name}-api"
  retention_in_days = 30
}

# `timeout` must stay well under LAG_MS in src/lambda/sync.ts, or a slow write could slip
# behind a sync cursor.
resource "aws_lambda_function" "api" {
  function_name                  = "${var.name}-api"
  role                           = aws_iam_role.api.arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  filename                       = data.archive_file.api.output_path
  source_code_hash               = data.archive_file.api.output_base64sha256
  memory_size                    = 256
  timeout                        = 10
  reserved_concurrent_executions = var.lambda_reserved_concurrency

  environment {
    variables = {
      TABLE = aws_dynamodb_table.data.name
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.api.name
  }

  depends_on = [aws_iam_role_policy.api]
}

# IAM auth: the URL answers only SigV4-signed requests, and only CloudFront (via OAC)
# is allowed to sign them. Hitting the raw lambda-url hostname gets a 403.
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "AWS_IAM"
}

resource "aws_lambda_permission" "cloudfront_url" {
  statement_id           = "AllowCloudFrontInvokeUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.app.arn
  function_url_auth_type = "AWS_IAM"
}

# Function URLs created since late 2025 also require lambda:InvokeFunction for the caller.
resource "aws_lambda_permission" "cloudfront_invoke" {
  statement_id  = "AllowCloudFrontInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.app.arn
}

# ---------------------------------------------------------------- cloudfront

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.name}-site-${local.suffix}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "api" {
  name                              = "${var.name}-api-${local.suffix}"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

# Forwards the viewer's headers (x-pullup-token, x-amz-content-sha256) but not Host,
# which a Lambda URL rejects when it doesn't match its own hostname.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${var.name}-security-${local.suffix}"
  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
      override                = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }
}

locals {
  api_host = split("/", aws_lambda_function_url.api.function_url)[2]
}

resource "aws_cloudfront_distribution" "app" {
  enabled             = true
  comment             = "${var.name} pull-up tracker"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  aliases             = local.custom_domain ? [var.domain_name] : []

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    origin_id                = "api"
    domain_name              = local.api_host
    origin_access_control_id = aws_cloudfront_origin_access_control.api.id
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = !local.custom_domain
    acm_certificate_arn            = local.custom_domain ? aws_acm_certificate_validation.app[0].certificate_arn : null
    ssl_support_method             = local.custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.custom_domain ? "TLSv1.2_2021" : "TLSv1"
  }

  lifecycle {
    # The distribution is on a CloudFront flat-rate plan, which attaches its own WAF web ACL.
    # Terraform can't manage the plan subscription yet, so leave the plan's ACL alone.
    ignore_changes = [web_acl_id]
  }
}

# ---------------------------------------------------------------- custom domain

data "aws_route53_zone" "app" {
  count        = local.custom_domain ? 1 : 0
  name         = var.dns_zone_name
  private_zone = false
}

resource "aws_acm_certificate" "app" {
  count             = local.custom_domain ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.custom_domain ? { for o in aws_acm_certificate.app[0].domain_validation_options : o.domain_name => o } : {}

  zone_id         = data.aws_route53_zone.app[0].zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

# Waits until ACM sees the validation record, which needs the zone's name servers to be live at the registrar.
resource "aws_acm_certificate_validation" "app" {
  count                   = local.custom_domain ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "app" {
  for_each = local.custom_domain ? toset(["A", "AAAA"]) : toset([])

  zone_id = data.aws_route53_zone.app[0].zone_id
  name    = var.domain_name
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.app.domain_name
    zone_id                = aws_cloudfront_distribution.app.hosted_zone_id
    evaluate_target_health = false
  }
}
