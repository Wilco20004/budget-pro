import { useEffect, useState } from 'react';
import { api } from '../api/client';
import CategorySelect from '../components/CategorySelect';
import { money, shortDate } from '../format';
import { Category, Product } from '../types';

export default function Products() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.products(q || undefined, cat ?? undefined).then(setProducts).catch((e) => setError(e.message));
  useEffect(() => {
    api.categories().then(setCategories).catch(() => undefined);
  }, []);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [q, cat]);

  return (
    <>
      <h1>Product database</h1>
      <p className="muted small" style={{ marginTop: -8 }}>
        Everything read off your slips. The category here is what the next slip with this product gets automatically — change it
        once and it sticks.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ marginBottom: '0.75rem' }}>
        <input placeholder="Search products…" value={q} onChange={(e) => setQ(e.target.value)} />
        <CategorySelect categories={categories} value={cat} onChange={setCat} placeholder="All categories" kinds={['expense', 'savings']} />
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th className="num">Bought</th>
                <th className="num">Last price</th>
                <th className="num">Avg price</th>
                <th className="num">Total spent</th>
                <th>Last bought</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>
                    <CategorySelect
                      categories={categories}
                      value={p.category_id}
                      kinds={['expense', 'savings']}
                      placeholder="Not set"
                      onChange={(id) => api.updateProduct(p.id, { category_id: id }).then(load).catch((e) => setError(e.message))}
                    />
                  </td>
                  <td className="num">{p.times_bought}×</td>
                  <td className="num">{money(p.last_unit_price)}</td>
                  <td className="num">{money(p.avg_unit_price)}</td>
                  <td className="num">{money(p.total_spent)}</td>
                  <td className="small">{shortDate(p.last_bought)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {products.length === 0 && <div className="empty">No products yet — they appear as slips are read.</div>}
      </div>
    </>
  );
}
