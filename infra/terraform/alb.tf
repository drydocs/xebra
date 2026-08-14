/**
 * apps/api is the one service anything outside the cluster talks to (docs/architecture.md §8 —
 * frontend never calls chain RPCs/Horizon directly). Everything else stays on the private
 * ecs-service module with no load balancer.
 */

resource "aws_security_group" "alb" {
  name_prefix = "xebra-${var.environment}-alb-"
  vpc_id      = module.network.vpc_id
  description = "Xebra API ALB — inbound 443 from the internet, outbound to ECS tasks."

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "xebra-${var.environment}-alb" }
}

resource "aws_security_group_rule" "ecs_tasks_from_alb" {
  type                     = "ingress"
  from_port                = 4000
  to_port                  = 4000
  protocol                 = "tcp"
  security_group_id        = module.network.ecs_tasks_security_group_id
  source_security_group_id = aws_security_group.alb.id
  description              = "apps/api port 4000, reachable only from the ALB."
}

resource "aws_lb" "api" {
  name               = "xebra-${var.environment}-api"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.network.public_subnet_ids
}

resource "aws_lb_target_group" "api" {
  name        = "xebra-${var.environment}-api"
  port        = 4000
  protocol    = "HTTP"
  vpc_id      = module.network.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }
}

resource "aws_acm_certificate" "api" {
  domain_name       = "api-${var.environment}.xebra.xyz"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "api_https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.api.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "api_http_redirect" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

/**
 * apps/web is the second (and last) publicly reachable service — a Next.js SSR app, so it needs
 * a running server behind a load balancer like apps/api, not static hosting. Kept as its own ALB
 * rather than host-based routing on the api ALB — two ALBs is a small, legible cost for not
 * coupling the api and web listener rulesets together.
 */

resource "aws_security_group" "alb_web" {
  name_prefix = "xebra-${var.environment}-alb-web-"
  vpc_id      = module.network.vpc_id
  description = "Xebra web ALB — inbound 443 from the internet, outbound to ECS tasks."

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "xebra-${var.environment}-alb-web" }
}

resource "aws_security_group_rule" "ecs_tasks_from_alb_web" {
  type                     = "ingress"
  from_port                = 3000
  to_port                  = 3000
  protocol                 = "tcp"
  security_group_id        = module.network.ecs_tasks_security_group_id
  source_security_group_id = aws_security_group.alb_web.id
  description              = "apps/web port 3000 (Next.js default), reachable only from the web ALB."
}

resource "aws_lb" "web" {
  name               = "xebra-${var.environment}-web"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb_web.id]
  subnets            = module.network.public_subnet_ids
}

resource "aws_lb_target_group" "web" {
  name        = "xebra-${var.environment}-web"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = module.network.vpc_id
  target_type = "ip"

  health_check {
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }
}

resource "aws_acm_certificate" "web" {
  domain_name       = var.environment == "production" ? "xebra.xyz" : "${var.environment}.xebra.xyz"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "web_https" {
  load_balancer_arn = aws_lb.web.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.web.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener" "web_http_redirect" {
  load_balancer_arn = aws_lb.web.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
