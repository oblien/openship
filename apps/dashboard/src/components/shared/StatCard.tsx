interface StatCardProps {
  number: string;
  label: string;
}

export default function StatCard({ number, label }: StatCardProps) {
  return (
    <div className="bg-white/5 backdrop-blur-[25px] rounded-[20px] p-6 text-center border border-white/10">
      <div className="text-3xl lg:text-4xl font-bold text-white mb-2">{number}</div>
      <div className="text-sm lg:text-base text-white/60">{label}</div>
    </div>
  );
}

