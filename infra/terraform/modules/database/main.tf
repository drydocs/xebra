/**
 * RDS Postgres — the queryable projection of on-chain state (packages/db's schema). Single
 * instance for staging; production should set `multi_az = true` and a larger instance class via
 * the environment's tfvars, not by editing this module.
 */

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = "xebra-${var.environment}"
  subnet_ids = var.private_subnet_ids
}

resource "aws_security_group" "db" {
  name_prefix = "xebra-${var.environment}-db-"
  vpc_id      = var.vpc_id
  description = "Xebra RDS Postgres — inbound 5432 from ECS tasks only."

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.ecs_tasks_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "xebra-${var.environment}-db" }
}

resource "aws_db_instance" "this" {
  identifier     = "xebra-${var.environment}"
  engine         = "postgres"
  engine_version = "17"

  instance_class        = var.instance_class
  allocated_storage     = var.allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  max_allocated_storage = var.allocated_storage_gb * 4

  db_name  = "xebra"
  username = "xebra"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]

  backup_retention_period = var.environment == "production" ? 7 : 1
  deletion_protection     = var.environment == "production"
  skip_final_snapshot     = var.environment != "production"

  tags = { Name = "xebra-${var.environment}" }
}

resource "aws_secretsmanager_secret" "db_url" {
  name = "xebra/${var.environment}/database-url"
}

resource "aws_secretsmanager_secret_version" "db_url" {
  secret_id     = aws_secretsmanager_secret.db_url.id
  secret_string = "postgres://${aws_db_instance.this.username}:${random_password.db.result}@${aws_db_instance.this.endpoint}/${aws_db_instance.this.db_name}"
}
