terraform {
  required_version = "= 1.13.5"
  backend "local" {}
  required_providers {
    github = {
      source  = "integrations/github"
      version = "= 6.13.0"
    }
  }
}
provider "github" { owner = var.owner }
