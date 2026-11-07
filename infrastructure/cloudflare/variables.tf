variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "Provide the protected account ID."
  }
}
variable "instance" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,23}[a-z0-9])?$", var.instance))
    error_message = "Use a short lowercase instance suffix ending in a letter or digit."
  }
}
variable "hostnames" {
  type = object({ study = string, control = string })
  validation {
    condition     = alltrue([for h in values(var.hostnames) : length(h) <= 253 && can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", h)) && !endswith(h, ".workers.dev")]) && var.hostnames.study != var.hostnames.control
    error_message = "Supply distinct custom hostnames, without paths or workers.dev."
  }
}
variable "owner_email" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[^@ ]+@[^@ ]+\\.[^@ ]+$", var.owner_email))
    error_message = "Supply the protected owner identity."
  }
}
variable "job_service_token_id" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9-]{36}$", var.job_service_token_id))
    error_message = "Supply an existing, separately issued Access service-token ID."
  }
}
variable "oauth_redirect_uris" {
  type = list(string)
  validation {
    condition     = length(var.oauth_redirect_uris) > 0 && alltrue([for u in var.oauth_redirect_uris : can(regex("^https://[^/ *]+/[^ ]*$", u))])
    error_message = "Supply the verified HTTPS callback URIs for the intended hosts."
  }
}
variable "zone_id" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.zone_id))
    error_message = "Provide the verified Cloudflare zone ID."
  }
}
variable "zone_name" {
  type = string
  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,63}$", var.zone_name))
    error_message = "Provide the verified zone name."
  }
}
variable "access_issuer" {
  type = string
  validation {
    condition     = can(regex("^https://[a-z0-9-]+\\.cloudflareaccess\\.com$", var.access_issuer))
    error_message = "Provide the verified Access team issuer."
  }
}
variable "deployment_service_token_id" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9-]{36}$", var.deployment_service_token_id))
    error_message = "Provide the existing deployment service token resource ID."
  }
}
