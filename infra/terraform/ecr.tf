/**
 * One ECR repo per deployable service — apps/web is a Next.js server too (not a static site
 * hosted elsewhere), so it gets a repo/service like every other app.
 */

locals {
  service_names = [
    "web", "api", "solver", "cctp-relay", "arbiter-service", "projector",
    "indexer-arc", "indexer-stellar", "indexer-solana",
  ]
}

resource "aws_ecr_repository" "this" {
  for_each             = toset(local.service_names)
  name                 = "xebra-${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}
