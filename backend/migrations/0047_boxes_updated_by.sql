alter table app.boxes
  add column if not exists updated_by text not null default '';
