variable "environment" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "service_name" {
  type = string
}

variable "image" {
  type        = string
  description = "Full ECR image URI, e.g. <account>.dkr.ecr.<region>.amazonaws.com/xebra-<service>:<tag>."
}

variable "cluster_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "cpu" {
  type    = number
  default = 256
}

variable "memory" {
  type    = number
  default = 512
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "environment_vars" {
  description = "Plain (non-secret) environment variables."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Env var name -> Secrets Manager ARN, injected at container start."
  type        = map(string)
  default     = {}
}

variable "secret_arns" {
  description = "Flat list of secret ARNs the execution role needs GetSecretValue on (derived from `secrets` at the call site, kept separate since a map's values alone don't give Terraform a stable list without this)."
  type        = list(string)
  default     = []
}

variable "task_role_policy_arns" {
  description = "Extra IAM policies to attach to the task role (e.g. arbiter-service's KMS usage policy)."
  type        = list(string)
  default     = []
}

variable "container_port" {
  description = "Port the container listens on, if this service is reachable from an ALB (currently only apps/api). Null for internal-only services."
  type        = number
  default     = null
}

variable "target_group_arn" {
  description = "ALB target group to register this service with. Null for internal-only services — see module doc comment."
  type        = string
  default     = null
}
