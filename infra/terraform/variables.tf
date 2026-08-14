variable "environment" {
  description = "Deployment environment name (e.g. staging, production)."
  type        = string
}

variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "az_count" {
  description = "Number of availability zones to spread subnets across."
  type        = number
  default     = 2
}

variable "db_instance_class" {
  description = "RDS instance class for the Postgres database."
  type        = string
  default     = "db.t4g.small"
}

variable "db_allocated_storage_gb" {
  description = "RDS allocated storage in GB."
  type        = number
  default     = 20
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "challenge_window_seconds_mainnet" {
  description = "Mainnet default challenge window (24h) — passed to contract deploy tooling, not a Terraform resource, but recorded here as the single source of truth for infra-adjacent config matching contracts/arc-evm and contracts/stellar-soroban's constructor params."
  type        = number
  default     = 86400
}
