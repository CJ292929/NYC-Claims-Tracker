import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileText } from "lucide-react";
import { useLocation } from "wouter";

/**
 * Minimum-viable placeholder for the sidebar's "Claims" nav item, so
 * clicking it doesn't 404. A real global claims view is future work.
 */
export default function ClaimsPlaceholder() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-[60vh] w-full flex items-center justify-center">
      <Card className="w-full max-w-lg mx-4 border-0 shadow-brand bg-white/90">
        <CardContent className="pt-8 pb-8 text-center">
          <div className="flex justify-center mb-6">
            <div className="h-16 w-16 rounded-full bg-brand-cream flex items-center justify-center">
              <FileText className="h-8 w-8 text-brand-blue" />
            </div>
          </div>
          <h1 className="text-2xl font-serif font-bold text-brand-blue mb-2">
            Claims View Coming Soon
          </h1>
          <p className="text-muted-foreground mb-8 leading-relaxed">
            A dedicated view across all patients' claims is planned for a future update.
            For now, claims are tracked per patient from their detail view.
          </p>
          <Button
            onClick={() => setLocation("/patients")}
            className="bg-brand-blue hover:bg-brand-blue-dark text-white"
          >
            Go to Patients
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
