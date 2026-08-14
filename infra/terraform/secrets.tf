/**
 * Hot-wallet secrets (solver's Solana/Stellar keys, the CCTP relay's Solana gas key). Terraform
 * creates the Secrets Manager *container* only — never a version with a real value, so a private
 * key is never written to Terraform state or a plan file. Values are set out-of-band post-apply
 * (`aws secretsmanager put-secret-value`), same operational split as `database` module's
 * generated password (which Terraform *does* own, since nothing external needs to pick that one).
 */

resource "aws_secretsmanager_secret" "solver_solana_keypair" {
  name = "xebra/${var.environment}/solver-solana-keypair"
}

resource "aws_secretsmanager_secret" "solver_stellar_secret" {
  name = "xebra/${var.environment}/solver-stellar-secret"
}

resource "aws_secretsmanager_secret" "relay_solana_keypair" {
  name = "xebra/${var.environment}/relay-solana-keypair"
}
