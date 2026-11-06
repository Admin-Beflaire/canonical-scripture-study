mock_provider "github" {}
variables {
  owner = "example-owner"
  repositories = {
    application = { name = "example-app", visibility = "public", enforce_protection = true, required_checks = ["Application checks"] }
    design      = { name = "example-design", visibility = "private", enforce_protection = false, required_checks = [] }
  }
}
run "free_account" {
  command = plan
  assert {
    condition     = length(github_repository.project) == 2 && length(github_branch_protection.main) == 1
    error_message = "Both repositories must render without assuming private-plan protection."
  }
  assert {
    condition     = alltrue([for repo in github_repository.project : !repo.allow_rebase_merge])
    error_message = "Rebase merges must remain disabled."
  }
  assert {
    condition     = alltrue([for repo in github_workflow_repository_permissions.project : repo.default_workflow_permissions == "read" && !repo.can_approve_pull_request_reviews])
    error_message = "Actions must remain read-only and cannot approve PRs."
  }
}
run "second_account" {
  command = plan
  variables {
    owner = "replacement-owner"
    repositories = {
      application = { name = "replacement-app", visibility = "public", enforce_protection = true, required_checks = ["Application checks"] }
      design      = { name = "replacement-design", visibility = "private", enforce_protection = true, required_checks = ["Design checks"] }
    }
  }
  assert {
    condition     = github_repository.project["application"].name == "replacement-app" && length(github_branch_protection.main) == 2
    error_message = "Replacement identities and supported private protection must render without source edits."
  }
}
run "reject_unprotected_application" {
  command = plan
  variables {
    repositories = {
      application = { name = "app", visibility = "public", enforce_protection = false, required_checks = [] }
      design      = { name = "design", visibility = "private", enforce_protection = false, required_checks = [] }
    }
  }
  expect_failures = [var.repositories]
}
