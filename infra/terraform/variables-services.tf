/**
 * Per-service configuration, mirrored 1:1 from each service's own src/config.ts zod schema (under
 * apps/) — see that file for what each var means and why it's required. Grouped here rather than inline in
 * services.tf so a reviewer can diff "what does this service need" without wading through the
 * for_each/module wiring. No defaults on chain-specific values (RPC URLs, contract/program
 * addresses, CCTP domain ids) — these differ per network and must come from an
 * environments/<env>.tfvars file; `terraform validate` doesn't require them to be set, only
 * `plan`/`apply` do.
 */

variable "image_tag" {
  description = "Container image tag to deploy for every service (set by CI to the release SHA/tag)."
  type        = string
  default     = "latest"
}

variable "kafka_brokers" {
  description = "Comma-separated Redpanda broker list (Redpanda Cloud in staging/production, per docs/architecture.md §11)."
  type        = string
}

# --- Arc (EVM) ---
variable "arc_rpc_url" {
  type = string
}
variable "arc_escrow_address" {
  type = string
}
variable "arc_chain_id" {
  type = number
}

# --- Stellar ---
variable "soroban_rpc_url" {
  type = string
}
variable "horizon_url" {
  type = string
}
variable "soroban_escrow_contract_id" {
  description = "Stellar-source XebraEscrow (Soroban) contract id, for the Stellar->Solana corridor."
  type        = string
}
variable "soroban_start_ledger" {
  description = "Ledger indexer-stellar starts polling getEvents from on first run — set to the Soroban escrow's deploy ledger."
  type        = number
}
variable "fulfillment_watch_addresses" {
  description = "Comma-separated Stellar addresses solvers pay `destAddress` to on the existing Arc->Stellar corridor."
  type        = string
}
variable "stellar_network_passphrase" {
  type = string
}

# --- Solana ---
variable "solana_rpc_url" {
  type = string
}
variable "solver_addresses" {
  description = "Comma-separated base58 Solana pubkeys indexer-solana watches for deliveries."
  type        = string
}

# --- CCTP (Stellar <-> Solana) ---
variable "stellar_cctp_domain_id" {
  type = number
}
variable "stellar_token_messenger_address" {
  type = string
}
variable "stellar_message_transmitter_address" {
  type = string
}
variable "stellar_usdc_address" {
  type = string
}
variable "solana_cctp_domain_id" {
  type = number
}
variable "solana_token_messenger_address" {
  type = string
}
variable "solana_message_transmitter_address" {
  type = string
}
variable "solana_usdc_address" {
  type = string
}
variable "iris_base_url" {
  description = "Circle Iris attestation API base URL (sandbox vs production per environment)."
  type        = string
  default     = "https://iris-api-sandbox.circle.com"
}

# --- Frontend (NEXT_PUBLIC_*, baked in at build time, not runtime container env — see note in
#     services.tf's web entry) ---
variable "public_api_url" {
  type = string
}
