alter table app.box_id_aliases
  drop constraint if exists box_id_aliases_org_id_canonical_box_id_fkey;

alter table app.box_id_aliases
  add constraint box_id_aliases_org_id_canonical_box_id_fkey
  foreign key (org_id, canonical_box_id)
  references app.boxes(org_id, box_id)
  on update cascade
  on delete cascade;
