output "api_alb_dns_name" {
  value = aws_lb.api.dns_name
}

output "web_alb_dns_name" {
  value = aws_lb.web.dns_name
}

output "database_endpoint" {
  value = module.database.endpoint
}

output "redis_endpoint" {
  value = module.cache.endpoint
}

output "ecr_repository_urls" {
  value = local.ecr_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}
