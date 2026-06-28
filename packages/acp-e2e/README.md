End-to-end test for `code_defect_fastlane` MVP.

Any e2e that creates a wrkq task must close the task during cleanup. Prefer a
workflow terminal transition when the scenario owns the lifecycle; otherwise
mark throwaway fixture tasks `completed` or `cancelled` before removing the test
database or ending the live smoke run.
