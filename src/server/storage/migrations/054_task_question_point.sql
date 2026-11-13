-- docs/plans/review-v2/ps4-plan.md section 5: the review point of a push-back question. A deleted point leaves the question.
ALTER TABLE task_question ADD COLUMN point INTEGER REFERENCES review_item (id) ON DELETE SET NULL;
