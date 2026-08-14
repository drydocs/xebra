module "network" {
  source = "./modules/network"

  environment = var.environment
  vpc_cidr    = var.vpc_cidr
  az_count    = var.az_count
}

module "database" {
  source = "./modules/database"

  environment                 = var.environment
  vpc_id                      = module.network.vpc_id
  private_subnet_ids          = module.network.private_subnet_ids
  ecs_tasks_security_group_id = module.network.ecs_tasks_security_group_id
  instance_class              = var.db_instance_class
  allocated_storage_gb        = var.db_allocated_storage_gb
}

module "cache" {
  source = "./modules/cache"

  environment                 = var.environment
  vpc_id                      = module.network.vpc_id
  private_subnet_ids          = module.network.private_subnet_ids
  ecs_tasks_security_group_id = module.network.ecs_tasks_security_group_id
  node_type                   = var.redis_node_type
}

module "kms" {
  source = "./modules/kms"

  environment = var.environment
}

resource "aws_ecs_cluster" "this" {
  name = "xebra-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}
