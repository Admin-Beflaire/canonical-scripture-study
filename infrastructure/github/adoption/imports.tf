# Adopt existing repositories and their settings before any GitHub apply.
# Import is conditional on the destination not already being tracked in state.
# All identities come from the reviewed, owner-supplied repository inputs.

import {
  for_each = var.repositories
  to       = github_repository.project[each.key]
  id       = each.value.name
}

import {
  for_each = var.repositories
  to       = github_branch_default.main[each.key]
  id       = each.value.name
}

import {
  for_each = var.repositories
  to       = github_actions_repository_permissions.project[each.key]
  id       = each.value.name
}

import {
  for_each = var.repositories
  to       = github_workflow_repository_permissions.project[each.key]
  id       = each.value.name
}

# Import only protections already configured/enforced in the selected inputs.
# If a protection rule does not exist remotely, stop and reconcile rather than
# let Terraform create it implicitly on the initial adoption run.
import {
  for_each = { for key, repo in var.repositories : key => repo if repo.enforce_protection }
  to       = github_branch_protection.main[each.key]
  id       = "${each.value.name}:main"
}
