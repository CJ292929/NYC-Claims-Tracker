import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: patients, error: pErr } = await supabase.from('patients').select('id, insurance');
if (pErr) { console.error('patients error:', pErr); process.exit(1); }
console.log('patients found:', patients.length);

for (const p of patients) {
  if (!p.insurance) continue;
  const { error } = await supabase
    .from('visit_records')
    .update({ insurance_company: p.insurance })
    .eq('patient_id', p.id)
    .is('insurance_company', null);
  if (error) {
    console.error('update error for', p.id, JSON.stringify(error));
  } else {
    console.log('updated patient', p.id, '->', p.insurance);
  }
}
console.log('backfill complete');
