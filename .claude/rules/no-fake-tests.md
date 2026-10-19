# No tests designed to pass

- A test exists to fail when the code is wrong. Write each assertion so you can name the bug that would break it.
- Never assert on the size or shape of the test's own input data (`vectors.length >= 25`, "has the minimum coverage", "fixture is not empty"). Coverage comes from the cases and what they exercise, not from counting them.
- Never assert a value against itself or against what the previous assertion already proved (a string compared to itself through another encoding, a regex check after an exact `toBe`).
- Never compute the expected value with the code under test. Expected values come from the spec, an independent implementation, or a hand-written literal.
- Never write a test whose only purpose is to raise a coverage number: no calling code without asserting on its result, no asserting `toBeDefined` or "does not throw" in place of a behaviour, no snapshots of anything nobody reviewed.
- One assertion per distinct behaviour. Repeating a call to assert the same claim again is padding.
- Never lower a threshold, exclude files, or add ignore comments to make coverage pass. If code is untestable, change the code or open an issue.
- Delete a test that cannot fail. If a reviewer asks "what bug does this catch?" and there is no answer, it goes.
