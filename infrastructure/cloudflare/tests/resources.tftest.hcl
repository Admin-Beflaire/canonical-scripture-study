mock_provider "cloudflare" {}
variables {
  account_id                  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  instance                    = "fixture-a"
  hostnames                   = { study = "study.example.invalid", control = "control.example.invalid" }
  owner_email                 = "owner@example.invalid"
  zone_id                     = "cccccccccccccccccccccccccccccccc"
  zone_name                   = "example.invalid"
  access_issuer               = "https://example.cloudflareaccess.com"
  deployment_service_token_id = "22222222-2222-4222-8222-222222222222"
  job_service_token_id        = "11111111-1111-4111-8111-111111111111"
  oauth_redirect_uris         = ["https://host.example.invalid/callback"]
}
run "protected_instance_a" {
  command = plan
  assert {
    condition     = cloudflare_r2_managed_domain.private.enabled == false
    error_message = "Bucket must not be public."
  }
  assert {
    condition     = length(cloudflare_zero_trust_access_application.host) == 2 && cloudflare_zero_trust_access_application.jobs.domain == "control.example.invalid/internal/jobs/*"
    error_message = "Two host resources and the specific job resource are required."
  }
  assert {
    condition     = alltrue([for app in cloudflare_zero_trust_access_application.host : app.oauth_configuration.enabled]) && cloudflare_zero_trust_access_policy.jobs.decision == "non_identity" && cloudflare_zero_trust_access_policy.deployment_check.decision == "non_identity" && length(cloudflare_zero_trust_access_application.host["study"].policies) == 2 && length(cloudflare_zero_trust_access_application.host["control"].policies) == 2
    error_message = "Host OAuth and job Service Auth must be separate."
  }
}
run "protected_instance_b" {
  command = plan
  variables {
    account_id    = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    instance      = "fixture-b"
    zone_id       = "dddddddddddddddddddddddddddddddd"
    zone_name     = "second.invalid"
    access_issuer = "https://second.cloudflareaccess.com"
    hostnames     = { study = "s.second.invalid", control = "c.second.invalid" }
  }
  assert {
    condition     = cloudflare_d1_database.data.name == "css-data-fixture-b" && cloudflare_r2_bucket.private.name == "css-private-fixture-b"
    error_message = "Instances must render without editing resource code."
  }
}
run "reject_shared_hostname" {
  command = plan
  variables {
    hostnames = { study = "same.example.invalid", control = "same.example.invalid" }
  }
  expect_failures = [var.hostnames]
}
run "reject_unresolved_account" {
  command = plan
  variables { account_id = "{{ACCOUNT_ID}}" }
  expect_failures = [var.account_id]
}

run "reject_malformed_dns" {
  command = plan
  variables {
    hostnames = { study = "a..example.invalid", control = "control.example.invalid" }
  }
  expect_failures = [var.hostnames]
}
run "reject_trailing_instance_hyphen" {
  command = plan
  variables { instance = "a-" }
  expect_failures = [var.instance]
}
