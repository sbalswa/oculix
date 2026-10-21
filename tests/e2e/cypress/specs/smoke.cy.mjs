const SMOKE_DOCUMENT = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Cypress smoke</title></head>
  <body>
    <button data-testid="cypress-smoke" type="button">ready</button>
    <script>
      document.querySelector("[data-testid=cypress-smoke]").addEventListener(
        "click",
        (event) => {
          event.currentTarget.textContent = "clicked";
        },
      );
    </script>
  </body>
</html>`;

describe("Cypress smoke", () => {
  it("runs a calculator-independent assertion in a real browser", () => {
    cy.document().then((document) => {
      document.open();
      document.write(SMOKE_DOCUMENT);
      document.close();
    });
    cy.get('[data-testid="cypress-smoke"]')
      .should("have.text", "ready")
      .click()
      .should("have.text", "clicked");
  });
});
