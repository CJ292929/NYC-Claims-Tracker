import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

const CHART_HEIGHT = 260;

export function PatientAnalytics({
  patientProgressData,
  clinicStatusData,
}: {
  patientProgressData: Array<{ session: number | null; remaining: number | null }>;
  clinicStatusData: Array<{ name: string; value: number; color: string }>;
}) {
  return (
    <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 xl:gap-6">
      <Card className="border-border shadow-sm rounded-xl">
        <CardHeader>
          <CardTitle className="text-base font-semibold text-brand-blue">Session Progress</CardTitle>
          <CardDescription className="text-xs">Sessions remaining over time for the selected patient</CardDescription>
        </CardHeader>
        <CardContent>
          {patientProgressData.length > 0 ? (
            <div style={{ height: CHART_HEIGHT }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={patientProgressData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F0E9DC" />
                  <XAxis dataKey="session" stroke="#6B7280" fontSize={12} />
                  <YAxis stroke="#6B7280" fontSize={12} />
                  <Tooltip contentStyle={{ backgroundColor: '#FAF5EE', border: '1px solid #F0E9DC', borderRadius: '8px' }} />
                  <Line type="monotone" dataKey="remaining" stroke="#1E3A5F" strokeWidth={2} dot={{ fill: '#E8A93C', r: 4 }} activeDot={{ r: 6 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div style={{ height: CHART_HEIGHT }} className="flex items-center justify-center text-sm text-muted-foreground">
              No session history to chart yet.
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border shadow-sm rounded-xl">
        <CardHeader>
          <CardTitle className="text-base font-semibold text-brand-blue">Clinic Overview</CardTitle>
          <CardDescription className="text-xs">Sessions for the selected patient</CardDescription>
        </CardHeader>
        <CardContent>
          <div style={{ height: CHART_HEIGHT }} className="flex items-center justify-center gap-6">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={clinicStatusData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {clinicStatusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Tooltip contentStyle={{ backgroundColor: '#FAF5EE', border: '1px solid #F0E9DC', borderRadius: '8px' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center justify-center gap-5 mt-1">
            {clinicStatusData.map((entry) => (
              <div key={entry.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                {entry.name}: <span className="font-semibold text-foreground">{entry.value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
