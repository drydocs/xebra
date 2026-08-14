terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state (docs/architecture.md §11) — bucket/table created out-of-band, not managed by
  # this config (a backend can't bootstrap the infra it depends on). Environment-specific key
  # supplied via `terraform init -backend-config=environments/<env>.backend.hcl`.
  backend "s3" {
    encrypt = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "xebra"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
