-- The review profile of a task (docs/plans/review-v2/spec.md section 6.2). Each step reads the profile by this ID at its start. Tasks
-- made before it keep NULL and use the default profile.
ALTER TABLE task ADD COLUMN profile TEXT;
