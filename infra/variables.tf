variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "pullups"
}

variable "region" {
  description = "Region for the buckets, Lambda and SSM parameter. CloudFront is global."
  type        = string
  default     = "us-west-2"
}

variable "domain_name" {
  description = "Optional custom hostname (e.g. pullups.example.com). Leave empty to use the cloudfront.net name."
  type        = string
  default     = ""
}

variable "dns_zone_name" {
  description = "Route 53 public hosted zone that domain_name lives in (e.g. example.com). Its certificate and alias records are created there. Required when domain_name is set."
  type        = string
  default     = ""

  validation {
    condition     = var.domain_name == "" || (var.dns_zone_name != "" && endswith(var.domain_name, ".${var.dns_zone_name}"))
    error_message = "dns_zone_name must be set, and domain_name must be a subdomain of it."
  }
}

variable "lambda_reserved_concurrency" {
  description = "Caps concurrent Lambda executions to bound cost under abuse. -1 leaves it unreserved (new accounts often cannot reserve)."
  type        = number
  default     = -1
}

variable "signup_open" {
  description = "Whether anyone can create an account. Every passkey binds to domain_name for good, so keep this false until the app is on its final domain."
  type        = bool
  default     = false
}
