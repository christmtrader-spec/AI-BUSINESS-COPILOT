"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle, LayoutDashboard, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Per-module error boundary (Phase 06 hardening).
 * A render/runtime error inside one module shows a contained, recoverable
 * fallback — the shell (sidebar/header) stays alive and other modules keep
 * working. Errors are logged to the console for diagnosis.
 */
export class ModuleBoundary extends Component<
  {
    moduleKey: string;
    children: ReactNode;
    /** Localized strings passed from the shell (class components can't use hooks). */
    title: string;
    description: string;
    retry: string;
    dashboardLabel: string;
    onDashboard: () => void;
  },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Surface for diagnostics; Next.js dev overlay also captures it.
    console.error("[ModuleBoundary]", this.props.moduleKey, error);
  }

  componentDidUpdate(prev: { moduleKey: string }) {
    // Navigating to a different module clears the error state automatically.
    if (prev.moduleKey !== this.props.moduleKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <Card className="border-destructive/30">
          <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
            <div className="bg-destructive/10 text-destructive flex size-12 items-center justify-center rounded-full">
              <AlertTriangle className="size-6" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <p className="text-base font-semibold">{this.props.title}</p>
              <p className="text-muted-foreground text-sm">
                {this.props.description}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" onClick={() => this.setState({ error: null })}>
                <RotateCcw className="size-4" aria-hidden="true" />
                {this.props.retry}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  this.setState({ error: null });
                  this.props.onDashboard();
                }}
              >
                <LayoutDashboard className="size-4" aria-hidden="true" />
                {this.props.dashboardLabel}
              </Button>
            </div>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}
