output "app_url" {
  value = var.domain_name == "" ? "https://${aws_cloudfront_distribution.app.domain_name}" : "https://${var.domain_name}"
}

output "distribution_id" {
  value = aws_cloudfront_distribution.app.id
}

output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "table_name" {
  value = aws_dynamodb_table.data.name
}

output "function_name" {
  value = aws_lambda_function.api.function_name
}
