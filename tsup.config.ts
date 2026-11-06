import { defineConfig } from 'tsup';

export default defineConfig({
  // Dos entradas: la principal (emisión) y `/ruc` (consulta RUC), separadas para que la emisión no cargue la consulta.
  entry: { index: 'src/index.ts', ruc: 'src/ruc-consult/index.ts' },
  format: ['esm', 'cjs'],
  // El código común de las dos entradas (p. ej. las clases de error) va en un chunk compartido, también en CJS: sin esto
  // cada entrada CJS lleva su propia copia de `SunatApiError` y `instanceof` falla entre `/ruc` y la entrada principal.
  splitting: true,
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
});
