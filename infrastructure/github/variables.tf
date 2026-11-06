variable "owner" {
  type        = string
  description = "GitHub owner; authentication is provided separately."
}
variable "repositories" {
  description = "Existing repository identities and plan-supported protection."
  type = map(object({
    name               = string
    visibility         = string
    enforce_protection = bool
    required_checks    = list(string)
  }))
  validation {
    condition = (
      toset(keys(var.repositories)) == toset(["application", "design"]) &&
      var.repositories.application.visibility == "public" &&
      var.repositories.design.visibility == "private" &&
      var.repositories.application.enforce_protection &&
      contains(var.repositories.application.required_checks, "Application checks") &&
      var.repositories.application.name != var.repositories.design.name
    )
    error_message = "Supply distinct public application and private design repositories; public protection must require Application checks."
  }
}
