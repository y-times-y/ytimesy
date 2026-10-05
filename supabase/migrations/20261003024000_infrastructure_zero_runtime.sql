-- Zero is a confirmed exhausted native cap, not an unknown runtime measurement.
alter table public.infrastructure_vm_admission
  drop constraint infrastructure_vm_admission_max_run_total_seconds_check;
alter table public.infrastructure_vm_admission
  add constraint infrastructure_vm_admission_max_run_total_seconds_check
  check (max_run_total_seconds >= 0);
