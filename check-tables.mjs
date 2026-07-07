import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Get all tables via PostgREST introspection
const resp = await fetch(process.env.SUPABASE_URL + '/rest/v1/', {
  headers: {
    'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
  }
});
const spec = await resp.json();
const tables = Object.keys(spec.paths || {}).filter(p => !p.startsWith('/rpc'));
console.log('Tables found:', tables.join(', '));

// Check columns of claims_records
const { data, error } = await supabase.from('claims_records').select('*').limit(1);
if (error) {
  console.log('claims_records error:', error.message);
} else {
  console.log('claims_records sample keys:', JSON.stringify(Object.keys(data?.[0] ?? {})));
}
