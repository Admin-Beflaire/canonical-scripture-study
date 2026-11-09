"""Adapter declarations and declarative recipe resolution (synthetic adapters only)."""
import unittest

from css_preparation.adapters import AdapterDeclaration, AdapterRegistry, RecipeError

TEXT = AdapterDeclaration('synthetic-text', '1', frozenset({'synthetic/plain'}), frozenset({'source_text'}),
                          frozenset({'encoding'}), ('no annotations',))


def recipe(**overrides):
    base = {'recipe_version': 'preparation-recipe/1', 'id': 'recipe-a', 'revision': 'r1',
            'adapter': {'name': 'synthetic-text', 'method_version': '1'}, 'input_format': 'synthetic/plain',
            'parameters': {'encoding': 'utf-8'}, 'native_extent': {'units': ['u1']}, 'capabilities': ['source_text'],
            'dependencies': []}
    base.update(overrides)
    return base


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.registry = AdapterRegistry()
        self.registry.register(TEXT)

    def test_resolves_declared_adapter(self):
        self.assertIs(self.registry.resolve(recipe()), TEXT)
        with self.assertRaises(ValueError):
            self.registry.register(TEXT)

    def test_rejects_recipes_that_do_not_fit(self):
        cases = [recipe(adapter={'name': 'synthetic-text', 'method_version': '2'}), recipe(input_format='synthetic/xml'),
                 recipe(capabilities=['word_index']), recipe(parameters={'script': 'run'}), recipe(credentials='x'),
                 recipe(recipe_version='preparation-recipe/0'), recipe(id='../escape')]
        for case in cases:
            with self.assertRaises(RecipeError, msg=str(case)):
                self.registry.resolve(case)


if __name__ == '__main__':
    unittest.main()
