output "bindings" {
  value = {
    account_id    = var.account_id
    zone_id       = var.zone_id
    zone_name     = var.zone_name
    instance      = var.instance
    hostnames     = var.hostnames
    access_issuer = var.access_issuer
    database_id   = cloudflare_d1_database.data.id
    database_name = cloudflare_d1_database.data.name
    bucket_name   = cloudflare_r2_bucket.private.name
    audiences = {
      study   = cloudflare_zero_trust_access_application.host["study"].aud
      control = cloudflare_zero_trust_access_application.host["control"].aud
      jobs    = cloudflare_zero_trust_access_application.jobs.aud
    }
  }
}
