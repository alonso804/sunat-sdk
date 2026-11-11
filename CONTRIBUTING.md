# Cómo contribuir

¡Gracias por querer ayudar! Abre un issue antes de hacer cambios grandes para acordar el enfoque.

## Entorno

```bash
pnpm install
pnpm check       # Biome
pnpm typecheck
pnpm test        # vitest
pnpm build
```

Antes de abrir el PR corre estos mismos comandos: son los que ejecuta el CI.

## Reglas

- `main` está protegida: todo entra por pull request con el CI en verde.
- Agrega o ajusta tests para cada cambio de comportamiento.
- Si cambia la API pública, anótalo en `CHANGELOG.md`.
- **Datos reales:** no incluyas certificados, credenciales ni comprobantes de clientes. Para fixtures usa RUC de
  prueba o datos públicos.

## Licencia

Al contribuir aceptas que tu aporte se publique bajo la licencia [MIT](LICENSE) del proyecto.
