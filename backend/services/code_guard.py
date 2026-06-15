"""AST-based guardrail for AI-generated Python before execution.

Blocks: imports, file/network/process access, eval/exec, dunder attribute
access, and other escape hatches. Defense-in-depth for the run_python tool.
"""
import ast

BLOCKED_CALLS = {
    "eval", "exec", "compile", "open", "input", "__import__", "globals",
    "locals", "vars", "getattr", "setattr", "delattr", "breakpoint", "exit",
    "quit", "memoryview",
}
BLOCKED_MODULES = {
    "os", "sys", "subprocess", "shutil", "pathlib", "socket", "requests",
    "urllib", "http", "ftplib", "smtplib", "pickle", "ctypes", "importlib",
    "builtins", "multiprocessing", "threading", "signal",
}
BLOCKED_ATTRIBUTES = {
    # pandas/plotly escape hatches that touch disk or eval strings
    "to_csv", "to_excel", "to_pickle", "to_parquet", "to_sql", "to_hdf",
    "read_csv", "read_excel", "read_pickle", "read_parquet", "read_sql",
    "read_html", "read_json", "write_image", "write_html", "eval", "query",
    "to_clipboard", "system", "popen", "spawn",
}


class _Guard(ast.NodeVisitor):
    def __init__(self):
        self.violations: list[str] = []

    def visit_Import(self, node):
        self.violations.append("imports are not allowed (pd, np, px, go are pre-loaded)")

    def visit_ImportFrom(self, node):
        self.violations.append("imports are not allowed (pd, np, px, go are pre-loaded)")

    def visit_Call(self, node):
        if isinstance(node.func, ast.Name) and node.func.id in BLOCKED_CALLS:
            self.violations.append(f"call to '{node.func.id}' is not allowed")
        self.generic_visit(node)

    def visit_Attribute(self, node):
        if node.attr.startswith("__"):
            self.violations.append(f"dunder attribute access '{node.attr}' is not allowed")
        elif node.attr in BLOCKED_ATTRIBUTES:
            self.violations.append(f"'{node.attr}' is not allowed (no file/network/eval access)")
        if isinstance(node.value, ast.Name) and node.value.id in BLOCKED_MODULES:
            self.violations.append(f"module '{node.value.id}' is not allowed")
        self.generic_visit(node)

    def visit_Name(self, node):
        if node.id.startswith("__"):
            self.violations.append(f"dunder name '{node.id}' is not allowed")
        self.generic_visit(node)


def validate(code: str) -> list[str]:
    """Return list of violations; empty list means the code passed the guard."""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"syntax error: {e}"]
    guard = _Guard()
    guard.visit(tree)
    return sorted(set(guard.violations))
