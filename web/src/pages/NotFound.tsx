import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="py-20 text-center">
      <p className="text-lg font-semibold text-slate-100">Page not found</p>
      <Link to="/" className="mt-3 inline-block text-sm text-indigo-300 hover:underline">
        Back to the overview
      </Link>
    </div>
  );
}
