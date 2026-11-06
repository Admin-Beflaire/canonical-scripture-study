"""Static dependency checks for the Python runtime modules."""

import ast
from pathlib import Path
import sys

ROOTS = {
    "shared-python": "packages/shared-python/src",
    "preparation": "services/maintenance/data-preparation/src",
}
ALLOWED = {
    "shared-python": {"shared-python"},
    "preparation": {"preparation", "shared-python"},
}
BRIDGES = {"subprocess", "multiprocessing", "importlib", "runpy", "ctypes"}


def module_identity(file):
    path = Path(file)
    for owner, root in ROOTS.items():
        if path.is_relative_to(root):
            parts = list(path.relative_to(root).with_suffix("").parts)
            if parts[-1] == "__init__":
                parts.pop()
            return owner, ".".join(parts)
    return None, None


def module_index(root):
    index = {}
    for owner, directory in ROOTS.items():
        for path in (root / directory).rglob("*.py"):
            _, name = module_identity(path.relative_to(root))
            if name in index:
                raise ValueError(f"Duplicate Python module: {name}")
            index[name] = owner
    return index


def check_source(root, file, source):
    owner, name = module_identity(file)
    if owner is None:
        return [f"{file}: unowned Python module path"]
    known = module_index(root)
    failures = []
    tree = ast.parse(source, filename=file)

    def dependency(module):
        top = module.split(".")[0]
        if top in BRIDGES:
            failures.append(f"{file}: runtime bridge dependency {module}")
        elif module in known:
            if known[module] not in ALLOWED[owner]:
                failures.append(f"{file}: forbidden dependency {module}")
        elif top not in sys.stdlib_module_names:
            failures.append(f"{file}: unknown or forbidden dependency {module}")

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                dependency(alias.name)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level:
                package = name.split(".") if Path(file).stem == "__init__" else name.split(".")[:-1]
                if node.level > len(package):
                    failures.append(f"{file}: relative import escapes module root")
                    continue
                module = ".".join(package[:len(package) - node.level + 1] + ([module] if module else []))
            dependency(module)
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in {"__import__", "eval", "exec"}:
                failures.append(f"{file}: dynamic code/import is not allowed")
            if isinstance(node.func, ast.Attribute):
                operation = node.func.attr
                if operation in {"import_module", "exec_module", "load_module", "system", "popen", "fork", "forkpty"} or operation.startswith(("exec", "spawn")):
                    failures.append(f"{file}: runtime execution bridge is not allowed")
    return failures


def main():
    root = Path(__file__).resolve().parents[1]
    failures = [
        failure
        for directory in ("services", "packages", "schemas")
        for path in (root / directory).rglob("*.py")
        for failure in check_source(root, path.relative_to(root), path.read_text(encoding="utf-8"))
    ]
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("Python dependency boundaries passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
