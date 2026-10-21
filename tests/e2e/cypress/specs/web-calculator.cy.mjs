describe("Web calculator", () => {
  it("calculates 7 × 34 = 238 through the visible interface", () => {
    cy.visit("/");

    cy.get('[data-testid="clear"]').click();
    cy.contains('button[data-action="digit"]', "7").click();
    cy.get('button[aria-label="Multiply"]').click();
    cy.contains('button[data-action="digit"]', "3").click();
    cy.contains('button[data-action="digit"]', "4").click();
    cy.get('button[aria-label="Equals"]').click();

    cy.get('[aria-label="Calculator display"]').should("have.text", "238");
    cy.screenshot("result", { capture: "viewport" });
  });
});
