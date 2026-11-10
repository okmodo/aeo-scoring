import React from "react";
import { actions, essentialAttributes } from "../sample";

const completeCount = essentialAttributes.reduce((sum, value) => sum + value, 0);
const attributeCount = essentialAttributes.length;
const maxOpportunity = Math.max(...actions.map(action => action.points));

const names = ["Product details", "Shipping", "Limitations", "llms.txt", "Agent guide"];

export function AttributeChart() {
  return <figure className="rd-chart rd-attribute-chart">
    <figcaption>
      <span className="rd-kicker">ESSENTIAL ATTRIBUTES</span>
      <h3>Make the details complete.</h3>
      <p>{completeCount} of {attributeCount} essential attributes are complete in this example.</p>
    </figcaption>
    <svg viewBox="0 0 360 100" role="img" aria-labelledby="attributes-title attributes-desc">
      <title id="attributes-title">Essential attribute completeness</title>
      <desc id="attributes-desc">Currently {completeCount} of {attributeCount} are complete. All {attributeCount} could be complete if the missing attributes are verified and published.</desc>
      <text x="0" y="27">Today</text>
      <text x="0" y="76">If verified &amp; published</text>
      {essentialAttributes.map((value, index) => <rect key={`before-${index}`} x={170 + index * 30} y="10" width="23" height="23" rx="4" className={value === 1 ? "rd-filled" : "rd-empty-cell"} />)}
      {essentialAttributes.map((value, index) => <rect key={`after-${index}`} x={170 + index * 30} y="59" width="23" height="23" rx="4" className={value === 1 ? "rd-filled" : "rd-potential"} />)}
    </svg>
    <div className="rd-legend">
      <span>
        <i className="rd-dot-filled" />Complete</span>
      <span>
        <i className="rd-dot-empty" />Missing</span>
      <span>
        <i className="rd-dot-potential" />Conditional</span>
    </div>
    <p className="rd-chart-note">The missing width, upper material and outsole material must be confirmed before publishing. The second row is a possibility, not an achieved result.</p>
  </figure>;
}

export function OpportunityChart({ selected, onSelect }: { selected: number; onSelect: (index: number) => void }) {
  return <div className="rd-opportunities">
    <div className="rd-chart-heading">
      <div>
        <span className="rd-kicker">WHERE TO FOCUS</span>
        <h3>Opportunities by action</h3>
      </div>
      <span>UP TO POINTS RECOVERABLE</span>
    </div>
    <p>Choose an action to see its evidence and what needs to happen. Points are conditional, not guaranteed.</p>
    <div className="rd-bars" aria-label="Conditional recoverable points by action">
      {actions.map((action, index) => <button className={`rd-bar ${selected === index ? "is-selected" : ""}`} key={action.title} onClick={() => onSelect(index)} aria-pressed={selected === index}>
        <span>{names[index]}</span>
        <span className="rd-bar-track">
          <span style={{ width: `${action.points / maxOpportunity * 100}%` }} />
        </span>
        <strong>+{action.points}</strong>
      </button>)}
    </div>
  </div>;
}
