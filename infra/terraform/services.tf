/**
 * One entry per deployable service, wired into a single `for_each` over the ecs-service module
 * instead of nine near-identical module blocks — see each service's own src/config.ts (under
 * apps/) for exactly what env vars/secrets it requires; this map just supplies them at the infra
 * layer.
 *
 * NEXT_PUBLIC_ vars on `web` are listed for completeness but only take effect if also passed as
 * Docker build args in CI (Next.js inlines NEXT_PUBLIC_ vars at build time, not container start)
 * — runtime env here is a no-op for those specific keys unless the image build step also reads
 * them.
 */

locals {
  ecr_url = {
    for name, repo in aws_ecr_repository.this : name => repo.repository_url
  }

  services = {
    api = {
      cpu    = 512
      memory = 1024
      environment_vars = {
        PORT = "4000"
      }
      secrets = {
        DATABASE_URL = module.database.database_url_secret_arn
      }
      task_role_policy_arns = []
      container_port        = 4000
      target_group_arn      = aws_lb_target_group.api.arn
    }

    web = {
      cpu    = 512
      memory = 1024
      environment_vars = {
        PORT                                   = "3000"
        NEXT_PUBLIC_API_URL                    = var.public_api_url
        NEXT_PUBLIC_ARC_CHAIN_ID               = tostring(var.arc_chain_id)
        NEXT_PUBLIC_ARC_RPC_URL                = var.arc_rpc_url
        NEXT_PUBLIC_SOROBAN_RPC_URL            = var.soroban_rpc_url
        NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE = var.stellar_network_passphrase
        NEXT_PUBLIC_STELLAR_ESCROW_CONTRACT_ID = var.soroban_escrow_contract_id
        NEXT_PUBLIC_STELLAR_USDC_SAC_ADDRESS   = var.stellar_usdc_address
      }
      secrets               = {}
      task_role_policy_arns = []
      container_port        = 3000
      target_group_arn      = aws_lb_target_group.web.arn
    }

    solver = {
      cpu    = 512
      memory = 1024
      environment_vars = {
        KAFKA_BROKERS              = var.kafka_brokers
        SOLANA_RPC_URL             = var.solana_rpc_url
        SOROBAN_RPC_URL            = var.soroban_rpc_url
        STELLAR_NETWORK_PASSPHRASE = var.stellar_network_passphrase
        STELLAR_ESCROW_CONTRACT_ID = var.soroban_escrow_contract_id
      }
      secrets = {
        SOLVER_SOLANA_KEYPAIR = aws_secretsmanager_secret.solver_solana_keypair.arn
        SOLVER_STELLAR_SECRET = aws_secretsmanager_secret.solver_stellar_secret.arn
      }
      task_role_policy_arns = []
      container_port        = null
      target_group_arn      = null
    }

    cctp-relay = {
      cpu    = 256
      memory = 512
      environment_vars = {
        REDIS_URL                           = "redis://${module.cache.endpoint}:6379"
        IRIS_BASE_URL                       = var.iris_base_url
        STELLAR_CCTP_DOMAIN_ID              = tostring(var.stellar_cctp_domain_id)
        STELLAR_TOKEN_MESSENGER_ADDRESS     = var.stellar_token_messenger_address
        STELLAR_MESSAGE_TRANSMITTER_ADDRESS = var.stellar_message_transmitter_address
        STELLAR_USDC_ADDRESS                = var.stellar_usdc_address
        SOLANA_CCTP_DOMAIN_ID               = tostring(var.solana_cctp_domain_id)
        SOLANA_TOKEN_MESSENGER_ADDRESS      = var.solana_token_messenger_address
        SOLANA_MESSAGE_TRANSMITTER_ADDRESS  = var.solana_message_transmitter_address
        SOLANA_USDC_ADDRESS                 = var.solana_usdc_address
        SOLANA_RPC_URL                      = var.solana_rpc_url
      }
      secrets = {
        RELAY_SOLANA_KEYPAIR = aws_secretsmanager_secret.relay_solana_keypair.arn
      }
      task_role_policy_arns = []
      container_port        = null
      target_group_arn      = null
    }

    arbiter-service = {
      cpu    = 256
      memory = 512
      environment_vars = {
        KAFKA_BROKERS              = var.kafka_brokers
        ARC_RPC_URL                = var.arc_rpc_url
        ARC_ESCROW_ADDRESS         = var.arc_escrow_address
        ARBITER_EVM_KMS_KEY_ID     = module.kms.evm_key_id
        SOROBAN_RPC_URL            = var.soroban_rpc_url
        STELLAR_ESCROW_CONTRACT_ID = var.soroban_escrow_contract_id
        STELLAR_NETWORK_PASSPHRASE = var.stellar_network_passphrase
        ARBITER_STELLAR_KMS_KEY_ID = module.kms.stellar_key_id
        SOLANA_RPC_URL             = var.solana_rpc_url
        HORIZON_URL                = var.horizon_url
        KMS_REGION                 = var.aws_region
      }
      secrets = {
        DATABASE_URL = module.database.database_url_secret_arn
      }
      task_role_policy_arns = [module.kms.usage_policy_arn]
      container_port        = null
      target_group_arn      = null
    }

    projector = {
      cpu    = 256
      memory = 512
      environment_vars = {
        KAFKA_BROKERS = var.kafka_brokers
      }
      secrets = {
        DATABASE_URL = module.database.database_url_secret_arn
      }
      task_role_policy_arns = []
      container_port        = null
      target_group_arn      = null
    }

    indexer-arc = {
      cpu    = 256
      memory = 512
      environment_vars = {
        ARC_RPC_URL        = var.arc_rpc_url
        ARC_ESCROW_ADDRESS = var.arc_escrow_address
        ARC_CHAIN_ID       = tostring(var.arc_chain_id)
        KAFKA_BROKERS      = var.kafka_brokers
      }
      secrets               = {}
      task_role_policy_arns = []
      container_port        = null
      target_group_arn      = null
    }

    indexer-stellar = {
      cpu    = 256
      memory = 512
      environment_vars = {
        SOROBAN_RPC_URL             = var.soroban_rpc_url
        HORIZON_URL                 = var.horizon_url
        SOROBAN_ESCROW_CONTRACT_ID  = var.soroban_escrow_contract_id
        SOROBAN_START_LEDGER        = tostring(var.soroban_start_ledger)
        FULFILLMENT_WATCH_ADDRESSES = var.fulfillment_watch_addresses
        KAFKA_BROKERS               = var.kafka_brokers
      }
      secrets               = {}
      task_role_policy_arns = []
      container_port        = null
      target_group_arn      = null
    }

    indexer-solana = {
      cpu    = 256
      memory = 512
      environment_vars = {
        SOLANA_RPC_URL   = var.solana_rpc_url
        SOLVER_ADDRESSES = var.solver_addresses
        KAFKA_BROKERS    = var.kafka_brokers
      }
      secrets               = {}
      task_role_policy_arns = []
      container_port        = null
      target_group_arn      = null
    }
  }
}

module "ecs_service" {
  for_each = local.services
  source   = "./modules/ecs-service"

  environment        = var.environment
  aws_region         = var.aws_region
  service_name       = each.key
  image              = "${local.ecr_url[each.key]}:${var.image_tag}"
  cluster_id         = aws_ecs_cluster.this.id
  private_subnet_ids = module.network.private_subnet_ids
  security_group_id  = module.network.ecs_tasks_security_group_id

  cpu              = each.value.cpu
  memory           = each.value.memory
  environment_vars = each.value.environment_vars
  secrets          = each.value.secrets
  secret_arns      = values(each.value.secrets)

  task_role_policy_arns = each.value.task_role_policy_arns
  container_port        = each.value.container_port
  target_group_arn      = each.value.target_group_arn
}
