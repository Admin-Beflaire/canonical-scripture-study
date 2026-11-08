# Terraform owns resources and Access. Wrangler alone owns Workers and routes.
resource "cloudflare_d1_database" "data" {
  account_id = var.account_id
  name       = "css-data-${var.instance}"
  lifecycle { prevent_destroy = true }
}
resource "cloudflare_r2_bucket" "private" {
  account_id = var.account_id
  name       = "css-private-${var.instance}"
  lifecycle { prevent_destroy = true }
}
resource "cloudflare_r2_managed_domain" "private" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.private.name
  enabled     = false
}
resource "cloudflare_zero_trust_access_policy" "owner" {
  account_id = var.account_id
  name       = "css-owner-${var.instance}"
  decision   = "allow"
  include    = [{ email = { email = var.owner_email } }]
}
# Study uses a distinct human identity policy; Control retains its existing owner policy.
resource "cloudflare_zero_trust_access_policy" "study_owner" {
  account_id = var.account_id
  name       = "css-study-owner-${var.instance}"
  decision   = "allow"
  include    = [{ email = { email = var.study_owner_email } }]
}
# Access allows the same deployment token on both hosts; Workers enforce check-only methods.
resource "cloudflare_zero_trust_access_policy" "deployment_check" {
  account_id = var.account_id
  name       = "css-deployment-check-${var.instance}"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = var.deployment_service_token_id } }]
}
resource "cloudflare_zero_trust_access_policy" "jobs" {
  account_id = var.account_id
  name       = "css-jobs-${var.instance}"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = var.job_service_token_id } }]
}
resource "cloudflare_zero_trust_access_application" "host" {
  for_each         = var.hostnames
  account_id       = var.account_id
  name             = "css-${each.key}-${var.instance}"
  type             = "self_hosted"
  domain           = each.value
  destinations     = [{ type = "public", uri = each.value }]
  session_duration = "1h"
  policies = [
    { id = each.key == "study" ? cloudflare_zero_trust_access_policy.study_owner.id : cloudflare_zero_trust_access_policy.owner.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.deployment_check.id, precedence = 2 }
  ]
  oauth_configuration = {
    enabled = true
    dynamic_client_registration = {
      enabled                = true
      allowed_uris           = var.oauth_redirect_uris
      allow_any_on_localhost = false
      allow_any_on_loopback  = false
    }
  }
}
# This more-specific path wins over the human Control application.
resource "cloudflare_zero_trust_access_application" "jobs" {
  account_id                = var.account_id
  name                      = "css-jobs-${var.instance}"
  type                      = "self_hosted"
  domain                    = "${var.hostnames.control}/internal/jobs/*"
  destinations              = [{ type = "public", uri = "${var.hostnames.control}/internal/jobs/*" }]
  service_auth_401_redirect = true
  policies                  = [{ id = cloudflare_zero_trust_access_policy.jobs.id, precedence = 1 }]
}
