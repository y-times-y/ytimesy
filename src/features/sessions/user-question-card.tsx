import { Check, MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import type { UserQuestionItem } from "#/domain/session-item";
import {
	USER_QUESTION_LIMITS,
	userQuestionAnswerText,
} from "#/domain/user-question";

export type UserQuestionActions = {
	readonly disabled: boolean;
	/** Sends the answer as the user's next message. */
	readonly onAnswer: (text: string) => void;
};

/**
 * Questions the agent asked with ask_user: each with its options as choices
 * and a field for the user's own answer. Answered, it shows the reply.
 */
export function UserQuestionCard({
	item,
	reply,
	actions,
}: {
	item: UserQuestionItem;
	/** The user's answer, once given. */
	reply: string | null;
	actions?: UserQuestionActions;
}) {
	const [chosen, setChosen] = useState<string[][]>(() =>
		item.questions.map(() => []),
	);
	const [other, setOther] = useState<string[]>(() =>
		item.questions.map(() => ""),
	);
	const answered = reply !== null;
	const open = !answered && !!actions;
	const answers = item.questions.map((_, index) => [
		...chosen[index],
		...(other[index].trim() ? [other[index].trim()] : []),
	]);
	const complete = answers.every((answer) => answer.length > 0);
	function toggle(index: number, label: string, multi: boolean) {
		setChosen((current) =>
			current.map((labels, at) => {
				if (at !== index) return labels;
				if (!multi) return labels[0] === label ? [] : [label];
				return labels.includes(label)
					? labels.filter((value) => value !== label)
					: [...labels, label];
			}),
		);
		// A single-choice question takes either an option or a typed answer.
		if (!multi)
			setOther((current) =>
				current.map((value, at) => (at === index ? "" : value)),
			);
	}
	return (
		<section
			className="user-question"
			data-answered={answered || undefined}
			aria-label="Question from the agent"
		>
			{item.questions.map((question, index) => (
				<fieldset
					// biome-ignore lint/suspicious/noArrayIndexKey: a card's questions keep their order
					key={index}
					className="user-question-block"
					disabled={!open || actions?.disabled}
				>
					<legend className="user-question-title">
						<MessageCircleQuestion size={14} aria-hidden="true" />
						{question.header ? (
							<span className="user-question-chip">{question.header}</span>
						) : null}
						<span>{question.question}</span>
					</legend>
					{open ? (
						<>
							<div className="user-question-options">
								{question.options.map((option) => {
									const selected = chosen[index].includes(option.label);
									return (
										<button
											key={option.label}
											type="button"
											data-multi={question.multiSelect || undefined}
											aria-pressed={selected}
											className="user-question-option"
											data-selected={selected || undefined}
											onClick={() =>
												toggle(index, option.label, !!question.multiSelect)
											}
										>
											<span className="user-question-mark" aria-hidden="true">
												{selected ? <Check size={12} /> : null}
											</span>
											<span className="user-question-option-text">
												<span className="user-question-label">
													{option.label}
												</span>
												{option.description ? (
													<span className="user-question-description">
														{option.description}
													</span>
												) : null}
											</span>
										</button>
									);
								})}
							</div>
							<input
								className="user-question-other"
								value={other[index]}
								maxLength={USER_QUESTION_LIMITS.answer}
								placeholder="Or type your own answer"
								aria-label={`Your own answer: ${question.question}`}
								onChange={(event) => {
									const value = event.target.value;
									setOther((current) =>
										current.map((text, at) => (at === index ? value : text)),
									);
									if (!question.multiSelect && value.trim())
										setChosen((current) =>
											current.map((labels, at) => (at === index ? [] : labels)),
										);
								}}
							/>
						</>
					) : null}
				</fieldset>
			))}
			{open ? (
				<footer className="user-question-actions">
					<button
						type="button"
						className="user-question-send"
						disabled={!complete || actions?.disabled}
						onClick={() =>
							actions?.onAnswer(userQuestionAnswerText(item.questions, answers))
						}
					>
						Send answer
					</button>
				</footer>
			) : reply ? (
				<p className="user-question-reply">
					<Check size={14} aria-hidden="true" />
					<span>{reply}</span>
				</p>
			) : null}
		</section>
	);
}
