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

variable "acm_certificate_arn" {
  description = "ACM certificate in us-east-1 covering domain_name. Required when domain_name is set."
  type        = string
  default     = ""
}

variable "lambda_reserved_concurrency" {
  description = "Caps concurrent Lambda executions to bound cost under abuse. -1 leaves it unreserved (new accounts often cannot reserve)."
  type        = number
  default     = -1
}
