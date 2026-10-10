-- Benchmark tasks declare agent limits up to eight hours; a whole lead/builder
-- evaluation tree may need more than 100 requests. Operator-only table.
alter table public.harness_evaluation_run
 drop constraint harness_evaluation_run_max_requests_check,
 add constraint harness_evaluation_run_max_requests_check check (max_requests between 1 and 1000),
 drop constraint harness_evaluation_run_max_tokens_check,
 add constraint harness_evaluation_run_max_tokens_check check (max_tokens between 1000 and 200000000);
