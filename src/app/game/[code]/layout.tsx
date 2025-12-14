import { ReactNode } from "react";

type Props = {
  children: ReactNode;
};

export default function GameLayout({ children }: Props) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      {children}
    </div>
  );
}
