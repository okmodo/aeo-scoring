import React from "react";
import { actions, checks } from "../sample";
import { fieldGroups } from "./fields";

export function FieldDetails() {
  return (
    <section className="rd-section rd-fields" id="field-changes" aria-labelledby="field-changes-title">
      <p className="rd-kicker">03 / FIELD-LEVEL CHANGES</p>
      <h2 id="field-changes-title">Exactly what to update.</h2>
      <p className="rd-fields-intro">These fictional templates need verification before publication. Bracketed text is a placeholder, not a product claim. Coordinate related changes together; field entries do not each represent separate points.</p>
      {fieldGroups.map(group => {
        const action = actions.find(item => item.title === group.action);
        return (
          <div className="rd-field-group" key={group.action}>
            <h3>{group.action}</h3>
            <div className="rd-field-list">
              {group.fields.map(field => (
                <article className="rd-field" key={field.name}>
                  <div className="rd-field-heading"><h4>{field.name}</h4><span>Needs verification</span></div>
                  <p><strong>Current finding:</strong> {field.finding}</p>
                  <div className="rd-field-template"><small>PROPOSED EDIT · NOT PUBLISH-READY</small><p>{field.edit}</p></div>
                  <dl>
                    <div><dt>Where to publish</dt><dd>{field.publish}</dd></div>
                    <div><dt>Owner</dt><dd>{field.owner}</dd></div>
                    <div><dt>Verify</dt><dd>{field.verify}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
            {action && <details className="rd-field-source"><summary>Fictional source evidence and related checks</summary><p>{action.evidence}</p><p>{action.ids.map(id => { const check = checks.find(item => item.id === id); return check ? `${check.full} (${id})` : id; }).join("; ")}</p></details>}
          </div>
        );
      })}
    </section>
  );
}
