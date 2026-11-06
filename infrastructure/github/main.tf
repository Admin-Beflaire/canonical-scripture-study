resource "github_repository" "project" {
  for_each               = var.repositories
  name                   = each.value.name
  visibility             = each.value.visibility
  has_issues             = true
  allow_merge_commit     = true
  allow_squash_merge     = true
  allow_rebase_merge     = false
  allow_auto_merge       = false
  delete_branch_on_merge = false
  archive_on_destroy     = true
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [description, homepage_url, topics, has_wiki, has_projects, has_discussions]
  }
}
resource "github_branch_default" "main" {
  for_each   = var.repositories
  repository = github_repository.project[each.key].name
  branch     = "main"
  rename     = false
}
resource "github_actions_repository_permissions" "project" {
  for_each        = var.repositories
  repository      = github_repository.project[each.key].name
  enabled         = true
  allowed_actions = "selected"
  allowed_actions_config {
    github_owned_allowed = true
    verified_allowed     = false
    patterns_allowed     = ["hashicorp/setup-terraform@b9cd54a3c349d3f38e8881555d616ced269862dd"]
  }
}
resource "github_workflow_repository_permissions" "project" {
  for_each                         = var.repositories
  repository                       = github_repository.project[each.key].name
  default_workflow_permissions     = "read"
  can_approve_pull_request_reviews = false
}
resource "github_branch_protection" "main" {
  for_each            = { for key, repo in var.repositories : key => repo if repo.enforce_protection }
  repository_id       = github_repository.project[each.key].node_id
  pattern             = "main"
  enforce_admins      = true
  allows_deletions    = false
  allows_force_pushes = false
  required_pull_request_reviews {
    required_approving_review_count = 0
  }
  required_status_checks {
    strict   = true
    contexts = each.value.required_checks
  }
}
