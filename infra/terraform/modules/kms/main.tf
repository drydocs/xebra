/**
 * KMS keys for the v1 arbiter role (packages/arbiter-signer) — no raw hot key
 * (docs/architecture.md §8). Two asymmetric SIGN_VERIFY keys: one secp256k1 for Arc's
 * `resolve()` (ECDSA.recover-compatible), one Ed25519 for the Stellar-source escrow's
 * `resolve()` (native `require_auth`). Key rotation is intentionally NOT enabled — asymmetric
 * KMS keys don't support automatic rotation the way symmetric keys do, since rotating would
 * change the public key/address the contracts were deployed trusting.
 */

resource "aws_kms_key" "arbiter_evm" {
  description              = "Xebra ${var.environment} arbiter — EVM (secp256k1), signs resolve() on contracts/arc-evm"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_SECG_P256K1"
  deletion_window_in_days  = 30

  tags = { Name = "xebra-${var.environment}-arbiter-evm" }
}

resource "aws_kms_alias" "arbiter_evm" {
  name          = "alias/xebra-${var.environment}-arbiter-evm"
  target_key_id = aws_kms_key.arbiter_evm.key_id
}

resource "aws_kms_key" "arbiter_stellar" {
  description              = "Xebra ${var.environment} arbiter — Stellar (Ed25519), signs resolve() on contracts/stellar-soroban"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_EDWARDS25519"
  deletion_window_in_days  = 30

  tags = { Name = "xebra-${var.environment}-arbiter-stellar" }
}

resource "aws_kms_alias" "arbiter_stellar" {
  name          = "alias/xebra-${var.environment}-arbiter-stellar"
  target_key_id = aws_kms_key.arbiter_stellar.key_id
}

data "aws_iam_policy_document" "arbiter_kms_usage" {
  statement {
    sid    = "AllowArbiterServiceSign"
    effect = "Allow"
    actions = [
      "kms:Sign",
      "kms:GetPublicKey",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.arbiter_evm.arn, aws_kms_key.arbiter_stellar.arn]
  }
}

resource "aws_iam_policy" "arbiter_kms_usage" {
  name   = "xebra-${var.environment}-arbiter-kms-usage"
  policy = data.aws_iam_policy_document.arbiter_kms_usage.json
}
