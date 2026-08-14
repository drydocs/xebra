output "evm_key_id" {
  value = aws_kms_key.arbiter_evm.key_id
}

output "stellar_key_id" {
  value = aws_kms_key.arbiter_stellar.key_id
}

output "usage_policy_arn" {
  value = aws_iam_policy.arbiter_kms_usage.arn
}
