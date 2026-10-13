"use client";

import {
	type AdditionalField as AdditionalFieldConfig,
	type AdditionalFieldFormValue,
	DEFAULT_ADDITIONAL_FIELD_VALIDATION_DEBOUNCE_MS,
	getFormFieldErrors,
	normalizeAuthFormServerError,
	validateAdditionalFieldRequired,
	validateAdditionalFieldValue,
	validateStringLength,
} from "@better-auth-ui/core";
import { useAuth } from "@better-auth-ui/react";
import {
	type AnyFormApi,
	createFormHook,
	createFormHookContexts,
} from "@tanstack/react-form";
import { Eye, EyeOff } from "lucide-react";
import {
	type ComponentProps,
	type FormEvent,
	type ReactNode,
	useRef,
	useState,
} from "react";

import { Button } from "#/components/ui/button.tsx";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
} from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "#/components/ui/input-group.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { AdditionalField, type AdditionalFieldProps } from "./additional-field";
import { PasswordStrengthMeter } from "./password-strength-meter";

const { fieldContext, formContext, useFieldContext, useFormContext } =
	createFormHookContexts();

const DEFAULT_AUTH_FORM_SERVER_ERROR = "Unable to submit this form. Try again.";

export function focusFirstInvalidAuthFormControl(form: HTMLFormElement) {
	requestAnimationFrame(() => {
		form
			.querySelector<HTMLElement>(
				'[aria-invalid="true"]:not([disabled]), :invalid:not([disabled])',
			)
			?.focus();
	});
}

function AuthFormFieldError() {
	const field = useFieldContext<unknown>();
	const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

	if (!isInvalid) return null;

	const errors = getFormFieldErrors(field.state.meta.errors);

	return errors.length > 0 ? <FieldError errors={errors} /> : null;
}

function AuthFormServerError() {
	const form = useFormContext();

	return (
		<form.Subscribe selector={(state) => state.errorMap.onServer}>
			{(error) => {
				const formError =
					error && typeof error === "object" && "form" in error
						? error.form
						: error;
				const errors = getFormFieldErrors(formError ? [formError] : []);
				return errors.length > 0 ? <FieldError errors={errors} /> : null;
			}}
		</form.Subscribe>
	);
}

export function setAuthFormServerError(
	form: AnyFormApi,
	error: unknown,
	fallbackMessage: string,
) {
	const normalized = normalizeAuthFormServerError(error, fallbackMessage);
	form.setErrorMap({
		onServer: {
			fields: normalized.fields ?? {},
			form: normalized.form,
		},
	});
}

export function clearAuthFormServerError(form: AnyFormApi) {
	form.setErrorMap({ onServer: { fields: {} } });
}

export function clearAuthFormFieldServerError(
	form: AnyFormApi,
	fieldName: string,
) {
	form.setErrorMap({ onServer: undefined });
	if (!fieldName) return;

	const fieldMeta = form.getFieldMeta(fieldName as never);
	if (!fieldMeta?.errorMap.onServer) return;

	form.setFieldMeta(fieldName as never, (current = fieldMeta) => ({
		...current,
		errorMap: { ...current.errorMap, onServer: undefined },
		errorSourceMap: { ...current.errorSourceMap, onServer: undefined },
	}));
}

export async function submitAuthForm(
	form: AnyFormApi,
	serverErrorMessage = DEFAULT_AUTH_FORM_SERVER_ERROR,
) {
	clearAuthFormServerError(form);
	try {
		await form.handleSubmit();
		return form.state.isValid;
	} catch (error) {
		if (!form.state.errorMap.onServer) {
			setAuthFormServerError(form, error, serverErrorMessage);
		}
		return false;
	}
}

type AuthFormRootProps = Omit<ComponentProps<"form">, "onSubmit"> & {
	onBeforeSubmit?: () => void;
	serverErrorMessage?: string;
};

function AuthFormRoot({
	children,
	onBeforeSubmit,
	onInput,
	serverErrorMessage = DEFAULT_AUTH_FORM_SERVER_ERROR,
	...props
}: AuthFormRootProps) {
	const form = useFormContext();
	const submittingRef = useRef(false);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submittingRef.current || form.state.isSubmitting) return;

		const formElement = event.currentTarget;
		onBeforeSubmit?.();
		submittingRef.current = true;
		try {
			const isValid = await submitAuthForm(form, serverErrorMessage);
			if (!isValid) focusFirstInvalidAuthFormControl(formElement);
		} finally {
			submittingRef.current = false;
		}
	}

	return (
		<form
			{...props}
			onInvalid={(event) =>
				focusFirstInvalidAuthFormControl(event.currentTarget)
			}
			onInput={(event) => {
				const target = event.target;
				const fieldName =
					target instanceof HTMLInputElement ||
					target instanceof HTMLSelectElement ||
					target instanceof HTMLTextAreaElement
						? target.name
						: "";
				clearAuthFormFieldServerError(form, fieldName);
				onInput?.(event);
			}}
			onSubmit={submit}
		>
			{children}
		</form>
	);
}

type AuthFormTextFieldProps = Omit<
	ComponentProps<typeof Input>,
	"name" | "onBlur" | "onChange" | "value"
> & {
	description?: ReactNode;
	label: ReactNode;
};

function AuthFormTextField({
	description,
	id,
	label,
	...props
}: AuthFormTextFieldProps) {
	const field = useFieldContext<string>();
	const form = useFormContext();
	const isInvalid = isAuthFormFieldInvalid(field.state.meta);
	const inputId = id ?? field.name;

	return (
		<Field data-invalid={isInvalid}>
			<FieldLabel htmlFor={inputId}>{label}</FieldLabel>
			<Input
				{...props}
				aria-busy={field.state.meta.isValidating || undefined}
				aria-invalid={isInvalid}
				id={inputId}
				name={field.name}
				onBlur={field.handleBlur}
				onChange={(event) => {
					clearAuthFormFieldServerError(form, field.name);
					field.handleChange(event.target.value);
				}}
				value={field.state.value}
			/>
			{description ? <FieldDescription>{description}</FieldDescription> : null}
			<AuthFormFieldError />
		</Field>
	);
}

function AuthFormSubmitButton({
	children,
	disabled,
	isPending,
	...props
}: ComponentProps<typeof Button> & { isPending?: boolean }) {
	const form = useFormContext();

	return (
		<form.Subscribe
			selector={(state) => [state.isSubmitting, state.isValidating] as const}
		>
			{([isSubmitting, isValidating]) => (
				<Button
					{...props}
					aria-busy={isPending || isSubmitting || undefined}
					aria-disabled={
						disabled || isPending || isSubmitting || isValidating || undefined
					}
					disabled={disabled || isPending || isSubmitting || isValidating}
					type="submit"
				>
					{isPending || isSubmitting ? (
						<Spinner data-icon="inline-start" />
					) : null}
					{children}
				</Button>
			)}
		</form.Subscribe>
	);
}

type AuthFormAdditionalFieldProps = Omit<
	AdditionalFieldProps,
	"errors" | "isInvalid" | "name" | "onBlur" | "onChange" | "value"
>;

function AuthFormAdditionalField(props: AuthFormAdditionalFieldProps) {
	const field = useFieldContext<AdditionalFieldFormValue>();
	const form = useFormContext();
	const isInvalid = isAuthFormFieldInvalid(field.state.meta);

	return (
		<AdditionalField
			{...props}
			errors={
				isInvalid ? getFormFieldErrors(field.state.meta.errors) : undefined
			}
			isInvalid={isInvalid}
			name={field.name}
			onBlur={field.handleBlur}
			onChange={(value) => {
				clearAuthFormFieldServerError(form, field.name);
				field.handleChange(value);
			}}
			value={field.state.value}
		/>
	);
}

/** A new-password input with a show/hide toggle; `error` overrides the field's own error. */
function AuthFormPasswordField({
	label,
	placeholder,
	minLength,
	maxLength,
	disabled,
	error,
	onValueChange,
	showStrength = false,
}: {
	label: ReactNode;
	placeholder?: string;
	minLength?: number;
	maxLength?: number;
	disabled?: boolean;
	error?: ReactNode;
	onValueChange?: () => void;
	showStrength?: boolean;
}) {
	const field = useFieldContext<string>();
	const { localization } = useAuth();
	const [visible, setVisible] = useState(false);
	const isInvalid = isAuthFormFieldInvalid(field.state.meta) || Boolean(error);
	const toggleLabel = visible
		? localization.auth.hidePassword
		: localization.auth.showPassword;

	return (
		<Field data-invalid={isInvalid}>
			<FieldLabel htmlFor={field.name}>{label}</FieldLabel>

			<InputGroup>
				<InputGroupInput
					id={field.name}
					name={field.name}
					type={visible ? "text" : "password"}
					autoComplete="new-password"
					placeholder={placeholder}
					required
					minLength={minLength}
					maxLength={maxLength}
					disabled={disabled}
					onBlur={field.handleBlur}
					onChange={(event) => {
						field.handleChange(event.target.value);
						onValueChange?.();
					}}
					aria-invalid={isInvalid}
					value={field.state.value}
				/>

				<InputGroupAddon align="inline-end">
					<InputGroupButton
						size="icon-xs"
						aria-label={toggleLabel}
						title={toggleLabel}
						onClick={() => setVisible((current) => !current)}
					>
						{visible ? <EyeOff /> : <Eye />}
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>

			{error ? <FieldError>{error}</FieldError> : <AuthFormFieldError />}

			{showStrength ? (
				<PasswordStrengthMeter password={field.state.value} />
			) : null}
		</Field>
	);
}

export const { useAppForm: useAuthForm } = createFormHook({
	fieldComponents: {
		AuthFormAdditionalField,
		AuthFormFieldError,
		AuthFormPasswordField,
		AuthFormTextField,
	},
	fieldContext,
	formComponents: {
		AuthFormRoot,
		AuthFormServerError,
		AuthFormSubmitButton,
	},
	formContext,
});

export function isAuthFormFieldInvalid({
	isTouched,
	isValid,
}: {
	isTouched: boolean;
	isValid: boolean;
}) {
	return isTouched && !isValid;
}

export function getAuthAdditionalFieldValidators(
	field: AdditionalFieldConfig,
	requiredMessage: string,
) {
	return {
		onChange: ({ value }: { value: AdditionalFieldFormValue }) =>
			validateAdditionalFieldRequired(field, value, requiredMessage),
		onChangeAsync: field.validate
			? ({ value }: { value: AdditionalFieldFormValue }) =>
					validateAdditionalFieldValue(field, value)
			: undefined,
		onChangeAsyncDebounceMs: field.validate
			? (field.validateDebounceMs ??
				DEFAULT_ADDITIONAL_FIELD_VALIDATION_DEBOUNCE_MS)
			: undefined,
	};
}

/** The configured password length rules, shared by new-password and confirm fields. */
export function passwordLengthError(
	value: string,
	limits:
		| { minPasswordLength?: number; maxPasswordLength?: number }
		| undefined,
	messages: { tooLong: string; tooShort: string; fieldRequired: string },
) {
	return validateStringLength(value, {
		maxLength: limits?.maxPasswordLength,
		maxLengthMessage: messages.tooLong.replace(
			"{{max}}",
			String(limits?.maxPasswordLength),
		),
		minLength: limits?.minPasswordLength,
		minLengthMessage: messages.tooShort.replace(
			"{{min}}",
			String(limits?.minPasswordLength),
		),
		requiredMessage: messages.fieldRequired,
	});
}
